# Plan 0008 — Valuation multiples for issuers quoted in a foreign currency

**Status: Complete** — as of 2026-08-14. All five phases shipped; every
"Objective check" bullet verified, including a re-run of `equity BNS --deep`
against the final renderer.

## Problem

A `--deep` equity run on `BNS` (2026-08-14, run
`2026-08-14T06-04-01-473Z-36963015`) produced a valuation table in which **all
ten rows are unavailable**. Two of them — the only two with a usable close price
— fail solely because the quote is in USD while the statements are in CAD:

```text
Basis  | Statement period | First eligible close | P/E                                | P/S
ANNUAL | 2024-10-31       | 70.55 USD (2025-12-02) | — (quote-reporting-currency-mismatch) | — (same)
ANNUAL | 2025-10-31       | 70.55 USD (2025-12-02) | — (quote-reporting-currency-mismatch) | — (same)
```

The block is at
[valuation-workbench.ts:464-467](../src/sources/extended-evidence/valuation-workbench.ts):

```ts
if (input.price.currency !== input.reportingCurrency) {
  ... "quote-reporting-currency-mismatch"
```

There is no currency conversion anywhere in `src/` — verified by grep for
exchange-rate, FX, and conversion helpers; the only hits are unrelated regexes in
untagged-table validation.

**Why this matters now.** Plan 0006 made foreign private issuers produce canonical
financial facts for the first time. This is the next gate they hit: any FPI listed
on a US exchange that reports in its home currency gets facts and then no
multiples. Scotiabank is not a special case — it is the shape of the whole
population plan 0006 unlocked.

## Investigation

Done before writing this plan, not assumed.

- **No FX capability exists.** Nothing to extend; this is new behaviour.
- **`fetchYahooCloseWindow(symbol, from, to)`
  ([yahoo.ts:700](../src/sources/yahoo.ts)) is generic over `symbol`.** Yahoo
  exposes FX pairs as `<BASE><QUOTE>=X` (e.g. `USDCAD=X`) on the same chart
  endpoint, so a daily FX series arrives through the identical fetch and parse
  path already used for equity closes. `fetchYahooJsonWithResilience` supplies
  retry and circuit-breaking on this path; only the close cache and
  collector-level rate limiting are absent. No new provider, no new credential,
  no new parser.
- **FRED is the weaker fit** despite already being configured. `fetchFredObservation`
  / `readFredObservationValue` ([fred.ts:58,125](../src/sources/fred.ts)) read only
  the *latest* observation, so historical rates would require extending it, and
  FRED covers only major pairs.
- The valuation table prices rows at a **historical** "first eligible close", so
  spot FX is not sufficient — a dated series is required.

## Decisions

| Question | Decision | Why |
| --- | --- | --- |
| FX source | Yahoo `<BASE><QUOTE>=X` via existing `fetchYahooCloseWindow` | Reuses the fetch/parse/cache path already in the repo. No new dependency or credential. |
| Convert which side? | **The price**, into the reporting currency | One number per row instead of every statement line. Statements stay authoritative and untouched. |
| Which date's rate? | The FX close on the **same date as the equity close**, else the most recent prior FX close | Both legs as-of the same day. Never a rate later than the close date — that would be look-ahead. |
| Result currency | Ratios are currency-neutral once numerator and denominator agree | P/E, P/S, EV/revenue, P/FCF are dimensionless; only the *inputs* must share a currency. |
| FX missing for a date | Keep the row unavailable, with a **new** distinct reason | Absence must stay explained. Do not silently fall back to an undated or spot rate. |
| Cite the rate | Yes — record rate, date, pair, and a `Source` for the FX series | Non-negotiable 2: every published number is sourced. A converted multiple is a derived number and must be auditable. |
| Use the native listing instead (BNS.TO) | **No** | It would silently answer a different question than the symbol the user asked for, and changes the observed price the whole report is built on. |

## Non-goals

- **Do not convert the statements.** Reporting currency stays as filed.
- **Do not convert the headline observed price** shown at the top of the report.
  That is the real market price in its real currency and must stay as-is; only
  the valuation-multiple inputs are converted.
- **Do not fix `debt-unavailable`.** Banks not tagging `Borrowings` blocks
  EV/revenue on 8 of 10 BNS rows. Real, separate, industry-concept-mapping scope.
- **Do not annotate absent Financial Trends columns.** Also real (Operating
  margin and FCF render as bare `—` while the valuation table annotates every
  absence), also separate.
- No new dependencies. Bun + oxc only (ADR 0002).

## Phases

### Phase 1 — Pin the current block

Files: `tests/valuation-workbench.test.ts` (or nearest existing suite)

Add a fixture with a CAD-reporting issuer and a USD quote. Assert today's
behaviour: every multiple unavailable with reason
`quote-reporting-currency-mismatch`.

Must pass now and fail in Phase 3, per the witness discipline used in plans 0006
and 0007.

Verification: `bun run check`.

### Phase 2 — Fetch a dated FX series

Files: `src/sources/yahoo.ts` (or a small adjacent module)

Add a function returning dated FX closes for a currency pair, built on
`fetchYahooCloseWindow`. It must:

- Construct the pair symbol correctly and **prove the direction**. Inverting a
  rate produces a plausible-looking wrong multiple (BNS P/E would be off by ~1.4x
  and still look reasonable) — this is the single most likely silent defect in the
  plan. Pin it with a test asserting a known-direction conversion against a fixed
  rate, not a round-trip, since a round-trip passes under inversion.
- Return the close on or before a requested date, never after.
- Emit a `SourceGap` when the pair or date is unavailable, rather than guessing.

No network in tests.

Verification: `bun run check`.

### Phase 3 — Convert the price for multiple inputs

Files: `src/sources/extended-evidence/valuation-workbench.ts`

Replace the hard block at `:464` with a conversion when a rate is available.
Record on each observation: the rate, its date, the pair, and the source id.

When no rate is available, keep the row unavailable under a **new** reason
distinct from `quote-reporting-currency-mismatch` so the two causes stay
separable in artifacts.

Tests: the Phase 1 fixture flips — multiples compute, and the recorded rate and
date appear on the observation. A missing rate still yields an unavailable row
with the new reason.

Verification: `bun run check`. **Goldens will move** for any fixture with a
currency mismatch — inspect each; a multiple appearing where none existed is
expected, a multiple *changing* on a same-currency fixture is a defect.

### Phase 4 — Surface it in the report

Files: `src/report/markdown.ts`

The valuation table must show that a converted rate was used, with its date. A
reader must never see a multiple and be unable to tell it crossed a currency.

Verification: `bun run check`, then re-run `equity BNS --deep` and confirm the
table shows computed multiples with a visible conversion note.

### Phase 5 — Full check

```bash
bun run check
```

## Risk

**This makes numbers appear in published research where the report previously
said "unavailable."** That is the point, and it is also the risk: a wrong rate or
an inverted pair yields a plausible multiple rather than a visible failure. The
direction test in Phase 2 is the primary guard, and it must assert against a known
rate rather than a round-trip.

Second risk: FX on non-trading days. The "on or before" rule keeps this
deterministic and free of look-ahead, but it means a multiple can use a rate a few
days older than its close. Recording the rate date makes that auditable rather
than hidden.

Phases 1, 4, 5 are low risk.

## Objective check

- A CAD-reporting issuer with a USD quote produces computed P/E and P/S.
- The recorded FX rate, its date, the pair, and a source id appear on the
  observation and in the artifact.
- No FX close later than the equity close date is ever used.
- An inverted rate fails a test.
- A missing rate yields an unavailable row under a reason distinct from
  `quote-reporting-currency-mismatch`.
- Same-currency issuers produce byte-identical multiples to today.
- A re-run of `equity BNS --deep` shows computed multiples with a visible
  conversion note.
- `bun run check` passes.
